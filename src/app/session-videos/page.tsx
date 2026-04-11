import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import SessionVideosClient from "./SessionVideosClient";

export default async function SessionVideosPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/session-videos");
  }
  return <SessionVideosClient />;
}
