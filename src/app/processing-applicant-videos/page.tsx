import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import ProcessingApplicantVideosClient from "./ProcessingApplicantVideosClient";

export default async function ProcessingApplicantVideosPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/processing-applicant-videos");
  }
  return <ProcessingApplicantVideosClient />;
}
