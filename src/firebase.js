import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyCVfXELwfW6dcYWrPbZYdh8zW6b-7dfQy4",
  authDomain: "redmrxgram.firebaseapp.com",
  projectId: "redmrxgram",
  storageBucket: "redmrxgram.firebasestorage.app",
  messagingSenderId: "512055244113",
  appId: "1:512055244113:web:78d3823515e9b2cbcb0f70"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
