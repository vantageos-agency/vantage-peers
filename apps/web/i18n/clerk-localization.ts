// i18n/clerk-localization.ts
import type { LocalizationResource } from "@clerk/types";

export const clerkLocalizations: Record<
	string,
	Partial<LocalizationResource>
> = {
	en: {}, // Use Clerk's default English
	fr: {
		signIn: {
			start: {
				title: "Connexion",
				subtitle: "Connectez-vous pour continuer vers VantageStarter",
				actionText: "Pas encore de compte ?",
				actionLink: "S'inscrire",
			},
		},
		signUp: {
			start: {
				title: "Créer un compte",
				subtitle: "Inscrivez-vous pour commencer avec VantageStarter",
				actionText: "Déjà un compte ?",
				actionLink: "Se connecter",
			},
		},
		userButton: {
			action__signOut: "Déconnexion",
			action__manageAccount: "Gérer le compte",
		},
	},
	de: {
		signIn: {
			start: {
				title: "Anmelden",
				subtitle: "Melden Sie sich an, um zu VantageStarter fortzufahren",
				actionText: "Noch kein Konto?",
				actionLink: "Registrieren",
			},
		},
		signUp: {
			start: {
				title: "Konto erstellen",
				subtitle: "Registrieren Sie sich, um mit VantageStarter zu beginnen",
				actionText: "Bereits ein Konto?",
				actionLink: "Anmelden",
			},
		},
		userButton: {
			action__signOut: "Abmelden",
			action__manageAccount: "Konto verwalten",
		},
	},
	it: {
		signIn: {
			start: {
				title: "Accedi",
				subtitle: "Accedi per continuare su VantageStarter",
				actionText: "Non hai un account?",
				actionLink: "Registrati",
			},
		},
		signUp: {
			start: {
				title: "Crea un account",
				subtitle: "Registrati per iniziare con VantageStarter",
				actionText: "Hai già un account?",
				actionLink: "Accedi",
			},
		},
		userButton: {
			action__signOut: "Disconnetti",
			action__manageAccount: "Gestisci account",
		},
	},
	es: {
		signIn: {
			start: {
				title: "Iniciar sesión",
				subtitle: "Inicia sesión para continuar a VantageStarter",
				actionText: "¿No tienes cuenta?",
				actionLink: "Regístrate",
			},
		},
		signUp: {
			start: {
				title: "Crear cuenta",
				subtitle: "Regístrate para comenzar con VantageStarter",
				actionText: "¿Ya tienes una cuenta?",
				actionLink: "Iniciar sesión",
			},
		},
		userButton: {
			action__signOut: "Cerrar sesión",
			action__manageAccount: "Gestionar cuenta",
		},
	},
	pt: {
		signIn: {
			start: {
				title: "Entrar",
				subtitle: "Entre para continuar no VantageStarter",
				actionText: "Não tem uma conta?",
				actionLink: "Cadastre-se",
			},
		},
		signUp: {
			start: {
				title: "Criar conta",
				subtitle: "Cadastre-se para começar com VantageStarter",
				actionText: "Já tem uma conta?",
				actionLink: "Entrar",
			},
		},
		userButton: {
			action__signOut: "Sair",
			action__manageAccount: "Gerenciar conta",
		},
	},
	ru: {
		signIn: {
			start: {
				title: "Вход",
				subtitle: "Войдите, чтобы продолжить в VantageStarter",
				actionText: "Нет аккаунта?",
				actionLink: "Зарегистрироваться",
			},
		},
		signUp: {
			start: {
				title: "Создать аккаунт",
				subtitle: "Зарегистрируйтесь, чтобы начать работу с VantageStarter",
				actionText: "Уже есть аккаунт?",
				actionLink: "Войти",
			},
		},
		userButton: {
			action__signOut: "Выйти",
			action__manageAccount: "Управление аккаунтом",
		},
	},
};
