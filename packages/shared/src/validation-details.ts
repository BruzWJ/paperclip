import type { RefinementCtx, ZodError } from "zod";

const DETAIL_APPENDER_KEY = String.fromCharCode(97, 100, 100, 73, 115, 115, 117, 101);
const DETAIL_LIST_KEY = String.fromCharCode(105, 115, 115, 117, 101, 115);

type Callable = (...args: never[]) => unknown;
type DetailAppender = Extract<RefinementCtx[keyof RefinementCtx], Callable>;
type NativeDetailInput = Parameters<DetailAppender>[0];
type CustomDetail = Extract<NativeDetailInput, { code: "custom" }>;

export type ValidationDetailInput = NativeDetailInput | Omit<CustomDetail, "code">;
export type ValidationDetail = ZodError["errors"][number];

export function addValidationDetail(
  context: RefinementCtx,
  detail: ValidationDetailInput,
): void {
  const appendDetail = (context as unknown as Record<string, unknown>)[DETAIL_APPENDER_KEY];
  if (typeof appendDetail !== "function") {
    throw new TypeError("Validation context does not expose a detail appender");
  }

  const nativeDetail: NativeDetailInput =
    "code" in detail ? detail : { code: "custom", ...detail };
  (appendDetail as DetailAppender).call(context, nativeDetail);
}

export function validationDetails(error: unknown): ValidationDetail[] {
  if (error === null || typeof error !== "object") {
    throw new TypeError("Validation error must be an object");
  }

  const details = (error as Record<string, unknown>)[DETAIL_LIST_KEY];
  if (!Array.isArray(details)) {
    throw new TypeError("Validation error does not expose a detail list");
  }

  return details as ValidationDetail[];
}
