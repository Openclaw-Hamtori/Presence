import { Linking } from "react-native";
import { parsePresenceLinkUrl } from "../deeplink";
import type { LinkCompletionEnvelope } from "../deeplink";

export async function getInitialPresenceLink(): Promise<LinkCompletionEnvelope | null> {
  try {
    const initialUrl = await Linking.getInitialURL();
    if (!initialUrl) return null;
    return parsePresenceLinkUrl(initialUrl);
  } catch {
    return null;
  }
}

export function subscribeToPresenceLinks(onLink: (envelope: LinkCompletionEnvelope, rawUrl: string) => void): () => void {
  const sub = Linking.addEventListener("url", ({ url }) => {
    const parsed = parsePresenceLinkUrl(url);
    if (parsed) onLink(parsed, url);
  });
  return () => sub.remove();
}
