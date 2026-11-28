```ts
class OAuth2AuthService extends AuthService {
  readonly options: OAuth2AuthOptions;
  constructor(options: OAuth2AuthOptions);
  getToken(): OAuth2TokenSet | undefined;
  setToken(token: OAuth2TokenSet | undefined): void;
  override authorize(ctx?: AuthContext): Promise<AuthResult>; // 解析 OAuth2 令牌并在即将过期时自动执行 single-flight 刷新
}
```
