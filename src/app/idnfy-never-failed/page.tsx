import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import IdnfyNeverFailedClient from "./IdnfyNeverFailedClient";

export default async function IdnfyNeverFailedPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/idnfy-never-failed");
  }
  return <IdnfyNeverFailedClient />;
}
