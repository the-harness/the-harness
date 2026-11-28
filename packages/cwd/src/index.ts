import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export class CwdService {
  readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  resolve(filePath: string): string {
    const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
    if (normalized === "~") {
      return homedir();
    }
    if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
      return resolve(homedir(), normalized.slice(2));
    }
    return isAbsolute(normalized) ? normalized : resolve(this.cwd, normalized);
  }
}
