export type EncodingPreference = {
  encoding: string;
  q: number;
};

export function parseAcceptEncoding(value: string | string[] | undefined): EncodingPreference[] {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (!raw) return [];

  return raw
    .split(",")
    .map((part) => {
      const [encodingPart, ...paramParts] = part.trim().split(";");
      const encoding = encodingPart?.trim().toLowerCase() ?? "";
      const qParam = paramParts
        .map((param) => param.trim())
        .find((param) => param.toLowerCase().startsWith("q="));
      const parsedQ = qParam ? Number(qParam.slice(2)) : 1;
      const q = Number.isFinite(parsedQ) ? parsedQ : 0;
      return { encoding, q };
    })
    .filter((entry) => entry.encoding.length > 0);
}
