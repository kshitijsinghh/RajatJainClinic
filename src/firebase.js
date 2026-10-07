import { initializeApp } from 'firebase/app';
import { getAuth, RecaptchaVerifier, signInWithPhoneNumber, signOut } from 'firebase/auth';

let _app = null;
let _auth = null;

function getFirebaseAuth() {
  if (_auth) return _auth;
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY || '';
  if (!apiKey) throw new Error('Firebase is not configured. Set VITE_FIREBASE_API_KEY.');
  _app = initializeApp({
    apiKey,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
    appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
  });
  _auth = getAuth(_app);
  return _auth;
}

export { getFirebaseAuth, RecaptchaVerifier, signInWithPhoneNumber, signOut };
