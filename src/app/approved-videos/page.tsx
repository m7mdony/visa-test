import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import ApprovedVideosClient from "./ApprovedVideosClient";

export default async function ApprovedVideosPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/approved-videos");
  }
  return <ApprovedVideosClient />;
}

