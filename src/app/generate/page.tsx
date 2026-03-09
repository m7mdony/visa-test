import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import GenerateClient from "./GenerateClient";

export default async function GeneratePage() {
  const cookieStore = await cookies();
  const authCookie = cookieStore.get("admin_auth")?.value;
  const isLoggedIn = authCookie === "true";

  if (!isLoggedIn) {
    redirect("/login?from=/generate");
  }

  return <GenerateClient />;
}

