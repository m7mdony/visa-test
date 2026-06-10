import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import UnrecoveredDeniedJobsClient from "./UnrecoveredDeniedJobsClient";

export default async function UnrecoveredDeniedJobsPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/unrecovered-denied-jobs");
  }
  return <UnrecoveredDeniedJobsClient />;
}
