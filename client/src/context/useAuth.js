import { createContext, useContext } from 'react';

// Live in their own non-JSX module so React Fast Refresh treats AuthContext.jsx
// as a pure component file. With the context object exported from the same
// .jsx file as the provider component, HMR would create a new context on every
// edit while leaving the consumer tree pointed at the old one, throwing the
// "useAuth must be used within an AuthProvider" runtime error.
export const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
