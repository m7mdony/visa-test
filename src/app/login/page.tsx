import LoginForm from "./LoginForm";

type LoginPageProps = {
  searchParams?: { from?: string };
};

export default function LoginPage({ searchParams }: LoginPageProps) {
  const from = searchParams?.from || "/generate";
  return <LoginForm from={from} />;
}


