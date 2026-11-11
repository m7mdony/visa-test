import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import DocumentVerificationFailedClient from "./DocumentVerificationFailedClient";

export default async function DocumentVerificationFailedPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/document-verification-failed");
  }
  return <DocumentVerificationFailedClient />;
}
