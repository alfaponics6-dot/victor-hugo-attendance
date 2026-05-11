import Toast from '../ui/Toast';

function Message({ type, text, onClose }) {
  if (!text) return null;
  return <Toast type={type || 'info'} text={text} onClose={onClose} className="mb-4" />;
}

export default Message;
