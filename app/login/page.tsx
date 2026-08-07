import LoginForm from "./LoginForm";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white border border-gray-300 rounded shadow-sm w-full max-w-sm p-8">
        <div className="flex justify-center mb-6">
          <img src="/logo.png" alt="Tracklink" className="h-8" />
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
