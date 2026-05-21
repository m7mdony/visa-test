import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import UnexpectedServerErrorsClient from "./UnexpectedServerErrorsClient";

export default async function UnexpectedServerErrorsPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/unexpected-server-errors");
  }
  return <UnexpectedServerErrorsClient />;
}

