import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import LogsClient from "./LogsClient";

export default async function LogsPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/logs");
  }
  return <LogsClient />;
}
