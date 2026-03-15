import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import ReportClient from "./ReportClient";

export default async function ReportPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/report");
  }
  return <ReportClient />;
}
