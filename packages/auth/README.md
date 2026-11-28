```ts
abstract class AuthService {
  abstract authorize(ctx?: AuthContext): Promise<AuthResult> | AuthResult;
}

class NoAuthService extends AuthService {
  override authorize(): AuthResult;
}

class ApiKeyAuthService extends AuthService {
  constructor(options: ApiKeyAuthOptions);
  override authorize(): Promise<AuthResult>;
}
```
