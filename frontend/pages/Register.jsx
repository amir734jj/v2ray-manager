import AccountForm from '../components/AccountForm.jsx';

export default function Register({ onRegistered }) {
  return <AccountForm registering onSuccess={onRegistered} />;
}
