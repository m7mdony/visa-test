import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import BookingJobsClient from "./BookingJobsClient";

export default async function BookingJobsPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/booking-jobs");
  }
  return <BookingJobsClient />;
}
