package app

import "net/http"

func (a *App) adminProviderAccounts(w http.ResponseWriter, r *http.Request) {
	a.nativeProviderAccounts(w, r)
}

func (a *App) adminProviderModels(w http.ResponseWriter, r *http.Request) {
	a.nativeProviderModels(w, r)
}

func (a *App) adminProviderAccountUpdate(w http.ResponseWriter, r *http.Request) {
	a.nativeProviderAccountUpdate(w, r)
}

func (a *App) adminProviderAccountDelete(w http.ResponseWriter, r *http.Request) {
	a.nativeProviderAccountDelete(w, r)
}

func (a *App) adminProviderAccountTest(w http.ResponseWriter, r *http.Request) {
	a.nativeProviderAccountTest(w, r)
}
