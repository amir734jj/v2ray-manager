import AccountForm from '../components/AccountForm.jsx';

export default function Login({ onLogin, notice }) {
  return <AccountForm onSuccess={onLogin} notice={notice} />;
}
