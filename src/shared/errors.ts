/** Base class for errors the service raises on purpose (as opposed to bugs). */
export class AppError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid or missing configuration. Lists every problem so startup fails once, not per field. */
export class ConfigError extends AppError {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
