import axios from 'axios';

export const api = axios.create({ timeout: 10000 });
export const errorMessage = error => error.response?.data?.error ?? error.message ?? 'Request failed';
