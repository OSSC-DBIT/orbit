import { OrbitError } from "./index.js";

/** Narrow helper so errors/index stays decoupled from HTTP concerns. */
export function isHTTPError(err: unknown): err is OrbitError & { httpStatus: number } {
  return err instanceof OrbitError && typeof err.httpStatus === "number";
}
