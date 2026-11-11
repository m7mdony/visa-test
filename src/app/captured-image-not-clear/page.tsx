import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import CapturedImageNotClearClient from "./CapturedImageNotClearClient";

export default async function CapturedImageNotClearPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/captured-image-not-clear");
  }
  return <CapturedImageNotClearClient />;
}
