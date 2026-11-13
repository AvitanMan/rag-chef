/** Shared error contract; importing it never composes Chef or a model transport. */
export class ChefServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ChefServiceError";
  }
}
