import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import PassportNumberExtractorClient from "./PassportNumberExtractorClient";

export default async function PassportNumberExtractorPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/passport-number-extractor");
  }
  return <PassportNumberExtractorClient />;
}
