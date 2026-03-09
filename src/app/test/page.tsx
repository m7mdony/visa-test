import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import TestClient from "./TestClient";

export default async function TestPage() {
  const cookieStore = await cookies();
  const authCookie = cookieStore.get("admin_auth")?.value;
  const isLoggedIn = authCookie === "true";

  if (!isLoggedIn) {
    redirect("/login?from=/test");
  }

  return <TestClient />;
}

