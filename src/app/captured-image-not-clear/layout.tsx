export default function CapturedImageNotClearLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen max-w-[100vw] px-3 sm:px-6">
      <div className="mx-auto w-full max-w-[1500px]">{children}</div>
    </div>
  );
}
