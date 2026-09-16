import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import WeCouldntDetectFaceClient from "./WeCouldntDetectFaceClient";

export default async function WeCouldntDetectFacePage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/we-couldnt-detect-face");
  }
  return <WeCouldntDetectFaceClient />;
}
