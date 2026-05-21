export function normalizeRemoteUrl(uri: string): string {
  try {
    const parsed = new URL(uri);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return uri;
  }
}
