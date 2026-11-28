export interface AuthContext {
  readonly url?: string;
  readonly method?: string;
  readonly signal?: AbortSignal;
}

export interface AuthResult {
  readonly headers: Readonly<Record<string, string>>;
  readonly apiKey?: string;
  readonly identityKey?: string;
}

export abstract class AuthService {
  abstract authorize(ctx?: AuthContext): Promise<AuthResult> | AuthResult;
}

export class NoAuthService extends AuthService {
  override authorize(): AuthResult {
    return { headers: {} };
  }
}

export interface ApiKeyAuthOptions {
  readonly apiKey: string | (() => Promise<string | undefined> | string | undefined);
  readonly headerName?: string;
  readonly scheme?: string;
}

export class ApiKeyAuthService extends AuthService {
  protected readonly options: ApiKeyAuthOptions;

  constructor(options: ApiKeyAuthOptions) {
    super();
    this.options = options;
  }

  override async authorize(): Promise<AuthResult> {
    const raw =
      typeof this.options.apiKey === "function" ? await this.options.apiKey() : this.options.apiKey;
    if (!raw) {
      return { headers: {} };
    }
    const headerName = this.options.headerName ?? "Authorization";
    const value =
      headerName.toLowerCase() === "authorization"
        ? `${this.options.scheme ?? "Bearer"} ${raw}`
        : raw;
    return {
      headers: { [headerName]: value },
      apiKey: raw,
      identityKey: `api-key:${headerName}:${raw}`,
    };
  }
}
