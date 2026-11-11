import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import PassportFromLogClient from "./PassportFromLogClient";

export default async function PassportFromLogPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/passport-from-log");
  }
  return <PassportFromLogClient />;
}
