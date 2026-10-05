//! Bounded, server-configured provider transports. Buyer inputs never select
//! endpoints, headers, tools, commands, or credentials.
use crate::execute::hash_canonical;
use crate::provider::{ConnectorType, IdempotencySupport, ProviderDefinitionV1};
use crate::secret::{secret_version_bindings, SecretResolver};
use reqwest::header::{HeaderName, HeaderValue, AUTHORIZATION, CONTENT_LENGTH, LOCATION};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::lookup_host;
use tokio::sync::Semaphore;
use url::Url;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectorProfileV1 {
    pub version: String,
    pub execution_profile: String,
    pub connector_type: ConnectorType,
    pub rest: Option<RestConnectorConfigV1>,
    pub mcp: Option<McpConnectorConfigV1>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestConnectorConfigV1 {
    pub base_endpoint: String,
    pub execute_path: String,
    pub status_path_template: Option<String>,
    pub allowed_hosts: Vec<String>,
    pub connect_timeout_ms: u64,
    pub request_timeout_ms: u64,
    pub maximum_response_bytes: usize,
    pub redirect_cap: usize,
    pub idempotency_header: Option<String>,
    pub bearer_secret_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpConnectorConfigV1 {
    pub endpoint: String,
    pub tool: String,
    pub status_tool: Option<String>,
    pub allowed_hosts: Vec<String>,
    pub connect_timeout_ms: u64,
    pub request_timeout_ms: u64,
    pub maximum_response_bytes: usize,
    pub redirect_cap: usize,
    pub bearer_secret_ref: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ConnectorRegistry {
    profiles: HashMap<String, ConnectorProfileV1>,
}

impl ConnectorRegistry {
    pub fn parse(bytes: &[u8], providers: &[ProviderDefinitionV1]) -> Result<Self, ConnectorError> {
        if bytes.len() > 1_048_576 {
            return Err(ConnectorError::configuration(
                "connector registry too large",
            ));
        }
        let profiles: Vec<ConnectorProfileV1> = serde_json::from_slice(bytes)
            .map_err(|_| ConnectorError::configuration("invalid connector registry"))?;
        if profiles.len() > 500 {
            return Err(ConnectorError::configuration(
                "connector registry capacity exceeded",
            ));
        }
        let mut providers_by_profile = HashMap::new();
        for provider in providers {
            if providers_by_profile
                .insert(provider.execution_profile.as_str(), provider)
                .is_some()
            {
                return Err(ConnectorError::configuration(
                    "duplicate provider execution profile",
                ));
            }
        }
        let mut indexed = HashMap::new();
        for profile in profiles {
            let provider = providers_by_profile
                .get(profile.execution_profile.as_str())
                .ok_or_else(|| ConnectorError::configuration("connector profile is unbound"))?;
            profile.validate(provider)?;
            if indexed
                .insert(profile.execution_profile.clone(), profile)
                .is_some()
            {
                return Err(ConnectorError::configuration("duplicate connector profile"));
            }
        }
        Ok(Self { profiles: indexed })
    }

    pub fn empty() -> Self {
        Self {
            profiles: HashMap::new(),
        }
    }

    pub fn get(&self, execution_profile: &str) -> Option<&ConnectorProfileV1> {
        self.profiles.get(execution_profile)
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn path(value: &str, template: bool) -> bool {
    value.starts_with('/')
        && value.len() <= 512
        && !value.starts_with("//")
        && !value.contains("..")
        && (!template || value.matches("{execution_id}").count() == 1)
}

fn host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value == value.to_ascii_lowercase()
        && !value.contains('/')
        && !value.contains('@')
        && !value.contains(char::is_whitespace)
}

fn validate_network(
    endpoint: &str,
    allowed_hosts: &[String],
    connect_timeout_ms: u64,
    request_timeout_ms: u64,
    maximum_response_bytes: usize,
    redirect_cap: usize,
) -> Result<(), ConnectorError> {
    let parsed = Url::parse(endpoint)
        .map_err(|_| ConnectorError::configuration("invalid provider endpoint"))?;
    if !matches!(parsed.scheme(), "https" | "http")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.host_str().is_none()
        || parsed.fragment().is_some()
        || parsed.query().is_some()
    {
        return Err(ConnectorError::configuration("invalid provider endpoint"));
    }
    if allowed_hosts.is_empty()
        || allowed_hosts.len() > 16
        || allowed_hosts.iter().any(|value| !host(value))
        || allowed_hosts.iter().collect::<HashSet<_>>().len() != allowed_hosts.len()
        || !allowed_hosts
            .iter()
            .any(|value| Some(value.as_str()) == parsed.host_str())
        || !(50..=30_000).contains(&connect_timeout_ms)
        || !(50..=120_000).contains(&request_timeout_ms)
        || connect_timeout_ms > request_timeout_ms
        || !(256..=1_048_576).contains(&maximum_response_bytes)
        || redirect_cap > 5
    {
        return Err(ConnectorError::configuration(
            "invalid provider network policy",
        ));
    }
    Ok(())
}

impl ConnectorProfileV1 {
    fn validate(&self, provider: &ProviderDefinitionV1) -> Result<(), ConnectorError> {
        if self.version != "1"
            || !identifier(&self.execution_profile)
            || self.execution_profile != provider.execution_profile
            || self.connector_type != provider.connector_type
        {
            return Err(ConnectorError::configuration(
                "invalid connector profile binding",
            ));
        }
        match (&self.connector_type, &self.rest, &self.mcp) {
            (ConnectorType::RestApi, Some(rest), None) => {
                validate_network(
                    &rest.base_endpoint,
                    &rest.allowed_hosts,
                    rest.connect_timeout_ms,
                    rest.request_timeout_ms,
                    rest.maximum_response_bytes,
                    rest.redirect_cap,
                )?;
                if !path(&rest.execute_path, false)
                    || rest
                        .status_path_template
                        .as_deref()
                        .is_some_and(|value| !path(value, true))
                    || (provider.recovery_capabilities.status_query
                        != rest.status_path_template.is_some())
                    || (provider.recovery_capabilities.idempotency == IdempotencySupport::Keyed)
                        != rest.idempotency_header.is_some()
                    || rest
                        .idempotency_header
                        .as_deref()
                        .is_some_and(|value| HeaderName::from_bytes(value.as_bytes()).is_err())
                    || rest
                        .bearer_secret_ref
                        .as_ref()
                        .is_some_and(|value| !provider.secret_refs.contains(value))
                {
                    return Err(ConnectorError::configuration(
                        "invalid REST connector semantics",
                    ));
                }
            }
            (ConnectorType::McpTool, None, Some(mcp)) => {
                validate_network(
                    &mcp.endpoint,
                    &mcp.allowed_hosts,
                    mcp.connect_timeout_ms,
                    mcp.request_timeout_ms,
                    mcp.maximum_response_bytes,
                    mcp.redirect_cap,
                )?;
                if !identifier(&mcp.tool)
                    || mcp
                        .status_tool
                        .as_deref()
                        .is_some_and(|value| !identifier(value))
                    || (provider.recovery_capabilities.status_query != mcp.status_tool.is_some())
                    || mcp
                        .bearer_secret_ref
                        .as_ref()
                        .is_some_and(|value| !provider.secret_refs.contains(value))
                {
                    return Err(ConnectorError::configuration(
                        "invalid MCP connector semantics",
                    ));
                }
            }
            _ => {
                return Err(ConnectorError::configuration(
                    "connector configuration mismatch",
                ))
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct ConnectorRuntimePolicy {
    pub allow_test_http: bool,
    pub allow_test_private_targets: bool,
    pub maximum_concurrency: usize,
}

impl Default for ConnectorRuntimePolicy {
    fn default() -> Self {
        Self {
            allow_test_http: false,
            allow_test_private_targets: false,
            maximum_concurrency: 16,
        }
    }
}

#[derive(Clone)]
pub struct ProviderConnectorRuntime {
    policy: ConnectorRuntimePolicy,
    semaphore: Arc<Semaphore>,
}

impl ProviderConnectorRuntime {
    pub fn new(policy: ConnectorRuntimePolicy) -> Result<Self, ConnectorError> {
        if !(1..=64).contains(&policy.maximum_concurrency) {
            return Err(ConnectorError::configuration(
                "invalid connector concurrency",
            ));
        }
        Ok(Self {
            semaphore: Arc::new(Semaphore::new(policy.maximum_concurrency)),
            policy,
        })
    }

    pub async fn execute(
        &self,
        profile: &ConnectorProfileV1,
        provider: &ProviderDefinitionV1,
        request: &ProviderExecutionRequestV1,
        resolver: &dyn SecretResolver,
    ) -> Result<ProviderObservationV1, ConnectorError> {
        profile.validate(provider)?;
        request.validate(provider)?;
        let _permit = self
            .semaphore
            .acquire()
            .await
            .map_err(|_| ConnectorError::unavailable("connector unavailable"))?;
        let mut observation = match (&profile.rest, &profile.mcp) {
            (Some(rest), None) => self.execute_rest(rest, provider, request, resolver).await,
            (None, Some(mcp)) => self.execute_mcp(mcp, provider, request, resolver).await,
            _ => Err(ConnectorError::configuration(
                "connector configuration mismatch",
            )),
        }?;
        bind_secret_versions(&mut observation, provider, resolver)?;
        Ok(observation)
    }

    pub async fn status(
        &self,
        profile: &ConnectorProfileV1,
        provider: &ProviderDefinitionV1,
        request: &ProviderExecutionRequestV1,
        execution_id: &str,
        resolver: &dyn SecretResolver,
    ) -> Result<ProviderObservationV1, ConnectorError> {
        profile.validate(provider)?;
        request.validate(provider)?;
        if !provider.recovery_capabilities.status_query || execution_id.is_empty() {
            return Err(ConnectorError::configuration(
                "provider status is unsupported",
            ));
        }
        let _permit = self
            .semaphore
            .acquire()
            .await
            .map_err(|_| ConnectorError::unavailable("connector unavailable"))?;
        let mut observation = match (&profile.rest, &profile.mcp) {
            (Some(rest), None) => {
                self.status_rest(rest, provider, request, execution_id, resolver)
                    .await
            }
            (None, Some(mcp)) => {
                self.status_mcp(mcp, provider, request, execution_id, resolver)
                    .await
            }
            _ => Err(ConnectorError::configuration(
                "connector configuration mismatch",
            )),
        }?;
        bind_secret_versions(&mut observation, provider, resolver)?;
        Ok(observation)
    }

    async fn execute_rest(
        &self,
        config: &RestConnectorConfigV1,
        provider: &ProviderDefinitionV1,
        request: &ProviderExecutionRequestV1,
        resolver: &dyn SecretResolver,
    ) -> Result<ProviderObservationV1, ConnectorError> {
        let url = join_endpoint(&config.base_endpoint, &config.execute_path)?;
        let response = self
            .post_json(
                url,
                &config.allowed_hosts,
                config.connect_timeout_ms,
                config.request_timeout_ms,
                config.maximum_response_bytes,
                config.redirect_cap,
                config.bearer_secret_ref.as_deref(),
                config.idempotency_header.as_deref(),
                Some(&request.execution_identity),
                request,
                resolver,
            )
            .await?;
        decode_provider_response(&response, provider, request, None)
    }

    async fn status_rest(
        &self,
        config: &RestConnectorConfigV1,
        provider: &ProviderDefinitionV1,
        request: &ProviderExecutionRequestV1,
        execution_id: &str,
        resolver: &dyn SecretResolver,
    ) -> Result<ProviderObservationV1, ConnectorError> {
        let encoded =
            url::form_urlencoded::byte_serialize(execution_id.as_bytes()).collect::<String>();
        let path = config
            .status_path_template
            .as_deref()
            .ok_or_else(|| ConnectorError::configuration("provider status is unsupported"))?
            .replace("{execution_id}", &encoded);
        let url = join_endpoint(&config.base_endpoint, &path)?;
        let response = self
            .get_json(
                url,
                &config.allowed_hosts,
                config.connect_timeout_ms,
                config.request_timeout_ms,
                config.maximum_response_bytes,
                config.redirect_cap,
                config.bearer_secret_ref.as_deref(),
                resolver,
            )
            .await?;
        decode_provider_response(&response, provider, request, Some(execution_id))
    }

    async fn execute_mcp(
        &self,
        config: &McpConnectorConfigV1,
        provider: &ProviderDefinitionV1,
        request: &ProviderExecutionRequestV1,
        resolver: &dyn SecretResolver,
    ) -> Result<ProviderObservationV1, ConnectorError> {
        self.initialize_mcp(config, resolver).await?;
        let payload = json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"tools/call",
            "params":{"name":config.tool,"arguments":request}
        });
        let (idempotency_header, idempotency_value) =
            if provider.recovery_capabilities.idempotency == IdempotencySupport::Keyed {
                (
                    Some("Idempotency-Key"),
                    Some(request.execution_identity.as_str()),
                )
            } else {
                (None, None)
            };
        let response = self
            .post_json(
                Url::parse(&config.endpoint)
                    .map_err(|_| ConnectorError::configuration("invalid provider endpoint"))?,
                &config.allowed_hosts,
                config.connect_timeout_ms,
                config.request_timeout_ms,
                config.maximum_response_bytes,
                config.redirect_cap,
                config.bearer_secret_ref.as_deref(),
                idempotency_header,
                idempotency_value,
                &payload,
                resolver,
            )
            .await?;
        let decoded: McpToolResponse = serde_json::from_slice(&response)
            .map_err(|_| ConnectorError::malformed("malformed MCP tool result"))?;
        if decoded.jsonrpc != "2.0" || decoded.id != 2 || decoded.result.tool != config.tool {
            return Err(ConnectorError::binding("unexpected MCP tool result"));
        }
        validate_provider_response(decoded.result.structured_content, provider, request, None)
    }

    async fn status_mcp(
        &self,
        config: &McpConnectorConfigV1,
        provider: &ProviderDefinitionV1,
        request: &ProviderExecutionRequestV1,
        execution_id: &str,
        resolver: &dyn SecretResolver,
    ) -> Result<ProviderObservationV1, ConnectorError> {
        self.initialize_mcp(config, resolver).await?;
        let tool = config
            .status_tool
            .as_deref()
            .ok_or_else(|| ConnectorError::configuration("provider status is unsupported"))?;
        let payload = json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"tools/call",
            "params":{"name":tool,"arguments":{"execution_id":execution_id,"execution_identity":request.execution_identity}}
        });
        let response = self
            .post_json(
                Url::parse(&config.endpoint)
                    .map_err(|_| ConnectorError::configuration("invalid provider endpoint"))?,
                &config.allowed_hosts,
                config.connect_timeout_ms,
                config.request_timeout_ms,
                config.maximum_response_bytes,
                config.redirect_cap,
                config.bearer_secret_ref.as_deref(),
                None,
                None,
                &payload,
                resolver,
            )
            .await?;
        let decoded: McpToolResponse = serde_json::from_slice(&response)
            .map_err(|_| ConnectorError::malformed("malformed MCP tool result"))?;
        if decoded.jsonrpc != "2.0" || decoded.id != 3 || decoded.result.tool != tool {
            return Err(ConnectorError::binding("unexpected MCP status tool result"));
        }
        validate_provider_response(
            decoded.result.structured_content,
            provider,
            request,
            Some(execution_id),
        )
    }

    async fn initialize_mcp(
        &self,
        config: &McpConnectorConfigV1,
        resolver: &dyn SecretResolver,
    ) -> Result<(), ConnectorError> {
        let payload = json!({
            "jsonrpc":"2.0",
            "id":1,
            "method":"initialize",
            "params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"setra402-provider-connector","version":"1"}}
        });
        let response = self
            .post_json(
                Url::parse(&config.endpoint)
                    .map_err(|_| ConnectorError::configuration("invalid provider endpoint"))?,
                &config.allowed_hosts,
                config.connect_timeout_ms,
                config.request_timeout_ms,
                config.maximum_response_bytes,
                config.redirect_cap,
                config.bearer_secret_ref.as_deref(),
                None,
                None,
                &payload,
                resolver,
            )
            .await?;
        let decoded: McpInitializeResponse = serde_json::from_slice(&response)
            .map_err(|_| ConnectorError::malformed("malformed MCP initialize result"))?;
        if decoded.jsonrpc != "2.0"
            || decoded.id != 1
            || decoded.result.protocol_version != "2025-03-26"
        {
            return Err(ConnectorError::binding("unexpected MCP initialize result"));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn post_json<T: Serialize + ?Sized>(
        &self,
        url: Url,
        allowed_hosts: &[String],
        connect_timeout_ms: u64,
        request_timeout_ms: u64,
        maximum_response_bytes: usize,
        redirect_cap: usize,
        bearer_secret_ref: Option<&str>,
        idempotency_header: Option<&str>,
        idempotency_value: Option<&str>,
        payload: &T,
        resolver: &dyn SecretResolver,
    ) -> Result<Vec<u8>, ConnectorError> {
        self.request_json(
            reqwest::Method::POST,
            url,
            allowed_hosts,
            connect_timeout_ms,
            request_timeout_ms,
            maximum_response_bytes,
            redirect_cap,
            bearer_secret_ref,
            idempotency_header,
            idempotency_value,
            Some(
                serde_json::to_vec(payload).map_err(|_| {
                    ConnectorError::configuration("provider request encoding failed")
                })?,
            ),
            resolver,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn get_json(
        &self,
        url: Url,
        allowed_hosts: &[String],
        connect_timeout_ms: u64,
        request_timeout_ms: u64,
        maximum_response_bytes: usize,
        redirect_cap: usize,
        bearer_secret_ref: Option<&str>,
        resolver: &dyn SecretResolver,
    ) -> Result<Vec<u8>, ConnectorError> {
        self.request_json(
            reqwest::Method::GET,
            url,
            allowed_hosts,
            connect_timeout_ms,
            request_timeout_ms,
            maximum_response_bytes,
            redirect_cap,
            bearer_secret_ref,
            None,
            None,
            None,
            resolver,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn request_json(
        &self,
        method: reqwest::Method,
        mut url: Url,
        allowed_hosts: &[String],
        connect_timeout_ms: u64,
        request_timeout_ms: u64,
        maximum_response_bytes: usize,
        redirect_cap: usize,
        bearer_secret_ref: Option<&str>,
        idempotency_header: Option<&str>,
        idempotency_value: Option<&str>,
        body: Option<Vec<u8>>,
        resolver: &dyn SecretResolver,
    ) -> Result<Vec<u8>, ConnectorError> {
        let initial_host = url.host_str().unwrap_or_default().to_string();
        let authorization = if let Some(secret_ref) = bearer_secret_ref {
            let secret = resolver
                .resolve(secret_ref)
                .map_err(|_| ConnectorError::unavailable("provider credential unavailable"))?;
            HeaderValue::from_str(&format!("Bearer {}", secret.expose()))
                .map_err(|_| ConnectorError::configuration("invalid provider credential"))?
                .into()
        } else {
            None
        };
        for redirects in 0..=redirect_cap {
            let (client, current_host) = self
                .client_for(&url, allowed_hosts, connect_timeout_ms, request_timeout_ms)
                .await?;
            let mut request = client
                .request(method.clone(), url.clone())
                .header(reqwest::header::ACCEPT, "application/json");
            if let Some(bytes) = &body {
                request = request
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(bytes.clone());
            }
            if current_host == initial_host {
                if let Some(value) = &authorization {
                    request = request.header(AUTHORIZATION, value.clone());
                }
            }
            if let (Some(name), Some(value)) = (idempotency_header, idempotency_value) {
                request = request.header(
                    HeaderName::from_bytes(name.as_bytes())
                        .map_err(|_| ConnectorError::configuration("invalid idempotency header"))?,
                    HeaderValue::from_str(value)
                        .map_err(|_| ConnectorError::configuration("invalid idempotency value"))?,
                );
            }
            let mut response = request
                .send()
                .await
                .map_err(|_| ConnectorError::unknown("provider acknowledgement unavailable"))?;
            if response.status().is_redirection() {
                if redirects == redirect_cap {
                    return Err(ConnectorError::unknown("provider redirect limit exceeded"));
                }
                if !matches!(
                    response.status(),
                    StatusCode::TEMPORARY_REDIRECT | StatusCode::PERMANENT_REDIRECT
                ) {
                    return Err(ConnectorError::unknown("unsafe provider redirect"));
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| ConnectorError::unknown("invalid provider redirect"))?;
                url = url
                    .join(location)
                    .map_err(|_| ConnectorError::unknown("invalid provider redirect"))?;
                continue;
            }
            if !response.status().is_success() {
                return Err(ConnectorError::unknown(
                    "provider returned no execution evidence",
                ));
            }
            if response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<usize>().ok())
                .is_some_and(|length| length > maximum_response_bytes)
            {
                return Err(ConnectorError::malformed("provider response too large"));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ConnectorError::unknown("provider response interrupted"))?
            {
                if bytes.len().saturating_add(chunk.len()) > maximum_response_bytes {
                    return Err(ConnectorError::malformed("provider response too large"));
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok(bytes);
        }
        Err(ConnectorError::unknown("provider redirect limit exceeded"))
    }

    async fn client_for(
        &self,
        url: &Url,
        allowed_hosts: &[String],
        connect_timeout_ms: u64,
        request_timeout_ms: u64,
    ) -> Result<(Client, String), ConnectorError> {
        if url.scheme() != "https" && !(self.policy.allow_test_http && url.scheme() == "http") {
            return Err(ConnectorError::target("provider endpoint requires HTTPS"));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(ConnectorError::target(
                "provider URL credentials are forbidden",
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| ConnectorError::target("provider endpoint has no host"))?
            .to_ascii_lowercase();
        if !allowed_hosts.iter().any(|allowed| allowed == &host) {
            return Err(ConnectorError::target("provider host is not allowlisted"));
        }
        let port = url
            .port_or_known_default()
            .ok_or_else(|| ConnectorError::target("provider endpoint has no port"))?;
        let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
            vec![SocketAddr::new(ip, port)]
        } else {
            lookup_host((host.as_str(), port))
                .await
                .map_err(|_| ConnectorError::unavailable("provider DNS unavailable"))?
                .collect::<Vec<_>>()
        };
        if addresses.is_empty()
            || addresses
                .iter()
                .any(|address| !self.policy.allow_test_private_targets && !public_ip(address.ip()))
        {
            return Err(ConnectorError::target(
                "provider target address is forbidden",
            ));
        }
        let builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_millis(connect_timeout_ms))
            .timeout(Duration::from_millis(request_timeout_ms))
            .resolve_to_addrs(&host, &addresses);
        let client = builder
            .build()
            .map_err(|_| ConnectorError::configuration("provider client configuration failed"))?;
        Ok((client, host))
    }
}

fn join_endpoint(base: &str, path: &str) -> Result<Url, ConnectorError> {
    let mut url =
        Url::parse(base).map_err(|_| ConnectorError::configuration("invalid provider endpoint"))?;
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || octets[0] == 0
        || octets[0] >= 224
        || octets == [169, 254, 169, 254]
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && matches!(octets[1], 18 | 19))
        || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113))
}

fn public_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProviderExecutionRequestV1 {
    pub version: String,
    pub provider_id: String,
    pub execution_identity: String,
    pub task_state_pda: String,
    pub task_id: String,
    pub service_id: String,
    pub input_hash: String,
    pub input: Value,
}

impl ProviderExecutionRequestV1 {
    fn validate(&self, provider: &ProviderDefinitionV1) -> Result<(), ConnectorError> {
        if self.version != "1"
            || self.provider_id != provider.provider_id
            || self.execution_identity.len() != 64
            || self.input_hash.len() != 64
            || self.task_id.parse::<u64>().is_err()
            || hash_canonical(&self.input).ok().as_deref() != Some(self.input_hash.as_str())
            || provider_execution_identity(
                &self.task_state_pda,
                &self.service_id,
                &self.input_hash,
                &self.provider_id,
            )
            .ok()
            .as_deref()
                != Some(self.execution_identity.as_str())
        {
            return Err(ConnectorError::binding(
                "invalid provider execution binding",
            ));
        }
        Ok(())
    }
}

pub fn provider_execution_identity(
    task_state_pda: &str,
    service_id: &str,
    input_hash: &str,
    provider_id: &str,
) -> Result<String, &'static str> {
    hash_canonical(&json!({
        "version":"1",
        "task_state_pda":task_state_pda,
        "service_id":service_id,
        "input_hash":input_hash,
        "provider_id":provider_id,
    }))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProviderResponseV1 {
    pub version: String,
    pub provider_id: String,
    pub execution_identity: String,
    pub task_state_pda: String,
    pub task_id: String,
    pub service_id: String,
    pub input_hash: String,
    pub execution_id: Option<String>,
    pub status: String,
    pub result: Option<Value>,
    pub receipt: Option<ProviderReceiptV1>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProviderReceiptV1 {
    pub version: String,
    pub provider_id: String,
    pub execution_identity: String,
    pub task_state_pda: String,
    pub task_id: String,
    pub service_id: String,
    pub input_hash: String,
    pub execution_id: Option<String>,
    pub status: String,
    pub result_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProviderObservationV1 {
    pub execution_id: Option<String>,
    pub status: String,
    pub result: Option<Value>,
    pub receipt_hash: Option<String>,
    pub response_commitment: String,
    pub observed_at_unix: i64,
    pub secret_versions: HashMap<String, String>,
}

fn decode_provider_response(
    bytes: &[u8],
    provider: &ProviderDefinitionV1,
    request: &ProviderExecutionRequestV1,
    expected_execution_id: Option<&str>,
) -> Result<ProviderObservationV1, ConnectorError> {
    let response: ProviderResponseV1 = serde_json::from_slice(bytes)
        .map_err(|_| ConnectorError::malformed("malformed provider response"))?;
    validate_provider_response(response, provider, request, expected_execution_id)
}

fn validate_provider_response(
    response: ProviderResponseV1,
    provider: &ProviderDefinitionV1,
    request: &ProviderExecutionRequestV1,
    expected_execution_id: Option<&str>,
) -> Result<ProviderObservationV1, ConnectorError> {
    if response.version != "1"
        || response.provider_id != request.provider_id
        || response.execution_identity != request.execution_identity
        || response.task_state_pda != request.task_state_pda
        || response.task_id != request.task_id
        || response.service_id != request.service_id
        || response.input_hash != request.input_hash
        || !matches!(response.status.as_str(), "PENDING" | "SUCCEEDED" | "FAILED")
        || expected_execution_id
            .is_some_and(|expected| response.execution_id.as_deref() != Some(expected))
    {
        return Err(ConnectorError::binding(
            "provider response binding mismatch",
        ));
    }
    if response.execution_id.is_some() != provider.recovery_capabilities.execution_id
        || response.receipt.is_some() != provider.recovery_capabilities.durable_receipt
        || (response.status == "SUCCEEDED") != response.result.is_some()
        || response
            .execution_id
            .as_deref()
            .is_some_and(|value| value.len() > 256)
    {
        return Err(ConnectorError::malformed(
            "provider response exceeds declared capabilities",
        ));
    }
    let result_hash = response
        .result
        .as_ref()
        .map(hash_canonical)
        .transpose()
        .map_err(ConnectorError::malformed)?;
    if response.receipt.as_ref().is_some_and(|receipt| {
        receipt.version != "1"
            || receipt.provider_id != request.provider_id
            || receipt.execution_identity != request.execution_identity
            || receipt.task_state_pda != request.task_state_pda
            || receipt.task_id != request.task_id
            || receipt.service_id != request.service_id
            || receipt.input_hash != request.input_hash
            || receipt.execution_id != response.execution_id
            || receipt.status != response.status
            || receipt.result_hash != result_hash
    }) {
        return Err(ConnectorError::binding("provider receipt binding mismatch"));
    }
    let response_value = serde_json::to_value(&response)
        .map_err(|_| ConnectorError::malformed("provider response encoding failed"))?;
    let receipt_hash = response
        .receipt
        .as_ref()
        .map(|receipt| {
            serde_json::to_value(receipt)
                .map_err(|_| "provider receipt encoding failed")
                .and_then(|value| hash_canonical(&value))
        })
        .transpose()
        .map_err(ConnectorError::malformed)?;
    let response_commitment = hash_canonical(&response_value).map_err(ConnectorError::malformed)?;
    let observed_at_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ConnectorError::unavailable("system clock unavailable"))?
        .as_secs() as i64;
    Ok(ProviderObservationV1 {
        execution_id: response.execution_id,
        status: response.status,
        result: response.result,
        receipt_hash,
        response_commitment,
        observed_at_unix,
        secret_versions: HashMap::new(),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpInitializeResponse {
    jsonrpc: String,
    id: u64,
    result: McpInitializeResult,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpInitializeResult {
    #[serde(rename = "protocolVersion")]
    protocol_version: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpToolResponse {
    jsonrpc: String,
    id: u64,
    result: McpToolResult,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpToolResult {
    tool: String,
    #[serde(rename = "structuredContent")]
    structured_content: ProviderResponseV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectorErrorKind {
    Configuration,
    RejectedTarget,
    UnavailableBeforeDispatch,
    UnknownExternalEffect,
    MalformedResponse,
    BindingMismatch,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectorError {
    pub kind: ConnectorErrorKind,
    message: &'static str,
}

impl ConnectorError {
    fn configuration(message: &'static str) -> Self {
        Self {
            kind: ConnectorErrorKind::Configuration,
            message,
        }
    }
    fn target(message: &'static str) -> Self {
        Self {
            kind: ConnectorErrorKind::RejectedTarget,
            message,
        }
    }
    fn unavailable(message: &'static str) -> Self {
        Self {
            kind: ConnectorErrorKind::UnavailableBeforeDispatch,
            message,
        }
    }
    fn unknown(message: &'static str) -> Self {
        Self {
            kind: ConnectorErrorKind::UnknownExternalEffect,
            message,
        }
    }
    fn malformed(message: &'static str) -> Self {
        Self {
            kind: ConnectorErrorKind::MalformedResponse,
            message,
        }
    }
    fn binding(message: &'static str) -> Self {
        Self {
            kind: ConnectorErrorKind::BindingMismatch,
            message,
        }
    }
}

impl std::fmt::Display for ConnectorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for ConnectorError {}

pub fn bind_secret_versions(
    observation: &mut ProviderObservationV1,
    provider: &ProviderDefinitionV1,
    resolver: &dyn SecretResolver,
) -> Result<(), ConnectorError> {
    observation.secret_versions = secret_version_bindings(resolver, &provider.secret_refs)
        .map_err(|_| ConnectorError::unavailable("provider credential unavailable"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_metadata_addresses_are_rejected() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(!public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(public_ip("1.1.1.1".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }
}
