import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import TestClient from "./TestClient";

type VideoGroup = {
  key: string;
  label: string;
  links: string[];
};

function readVideoGroupsFromEnv(): VideoGroup[] {
  const fallbackPrefix = "TEST_VIDEO_GROUP_";
  const overridePrefix = process.env.TEST_VIDEO_GROUP_PREFIX ?? "";
  const prefixes = [fallbackPrefix, overridePrefix].filter(Boolean);
  const groups: VideoGroup[] = [];

  for (const [envKey, rawValue] of Object.entries(process.env)) {
    const matchedPrefix = prefixes.find((p) => envKey.startsWith(p));
    if (!matchedPrefix) continue;
    if (typeof rawValue !== "string") continue;

    const groupKey = envKey.slice(matchedPrefix.length).trim();
    if (!groupKey) continue;

    const links = rawValue
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (links.length === 0) continue;

    groups.push({ key: groupKey, label: groupKey, links });
  }

  groups.sort((a, b) => a.key.localeCompare(b.key));
  return groups;
}

export default async function TestPage() {
  const cookieStore = await cookies();
  const authCookie = cookieStore.get("admin_auth")?.value;
  const isLoggedIn = authCookie === "true";

  if (!isLoggedIn) {
    redirect("/login?from=/test");
  }

  const videoGroups = readVideoGroupsFromEnv();
  return <TestClient videoGroups={videoGroups} />;
}

