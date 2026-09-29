// Wikimedia OAuth 2.0 (authorization code grant) against meta.wikimedia.org
function createOAuthClient(config, { fetchImpl = globalThis.fetch } = {}) {
  const { clientId, clientSecret, redirectUri, baseUrl } = config.oauth;

  function isConfigured() {
    return !!(clientId && clientSecret && redirectUri);
  }

  function authorizeUrl(state) {
    const url = new URL(`${baseUrl}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async function tokenRequest(params) {
    const res = await fetchImpl(`${baseUrl}/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': config.userAgent },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }).toString()
    });
    if (!res.ok) {
      throw new Error(`OAuth token request failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (!data.access_token) throw new Error('OAuth token response did not include an access token.');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null
    };
  }

  function exchangeCode(code) {
    return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }

  function refresh(refreshToken) {
    return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async function profile(accessToken) {
    const res = await fetchImpl(`${baseUrl}/resource/profile`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': config.userAgent }
    });
    if (!res.ok) throw new Error(`OAuth profile request failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  return { isConfigured, authorizeUrl, exchangeCode, refresh, profile };
}

module.exports = { createOAuthClient };
