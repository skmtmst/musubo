'use client'

import { createContext, useContext } from 'react'

export const AuthRefreshContext = createContext(false)
export function useAuthSessionRefreshing() { return useContext(AuthRefreshContext) }
