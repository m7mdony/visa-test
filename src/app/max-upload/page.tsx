import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import MaxUploadClient from "./MaxUploadClient";

export default async function MaxUploadPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/max-upload");
  }
  return <MaxUploadClient />;
}
