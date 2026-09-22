import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import StuckFeedbackClient from "./StuckFeedbackClient";

export default async function StuckFeedbackPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/stuck-feedback");
  }
  return <StuckFeedbackClient />;
}
