import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import VfsLogsClient from "./VfsLogsClient";

export default async function VfsLogsPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/vfs-logs");
  }
  return <VfsLogsClient />;
}

