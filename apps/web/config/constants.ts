export const DURATIONS = [5, 10] as const;

export const MOCK_VIDEO_URL = "/mock.mp4";

export const MAX_DURATION = 60;

export const DEFAULT_SCENES = [
	{
		id: "scene-1",
		title: "Opening Welcome",
		description: "A warm, intimate greeting featuring couple's names",
		duration: 10,
		cinematicStyles: {
			ambiance: "",
			cameraMovement: "",
			colorTone: "",
			visualStyle: "",
		},
	},
	{
		id: "scene-2",
		title: "Event Details",
		description: "Essential information with elegant typography",
		duration: 10,
		cinematicStyles: {
			ambiance: "",
			cameraMovement: "",
			colorTone: "",
			visualStyle: "",
		},
	},
	{
		id: "scene-3",
		title: "Call to Action",
		description: "Heartfelt invitation with RSVP request",
		duration: 10,
		cinematicStyles: {
			ambiance: "",
			cameraMovement: "",
			colorTone: "",
			visualStyle: "",
		},
	},
] as const;

export const PROJECT_ASSETS = [
	{
		id: "asset-1",
		name: "Romantic Couple",
		url: "/romantic-couple.png",
		type: "project",
	},
	{
		id: "asset-2",
		name: "Wedding Sunset",
		url: "/elegant-wedding-sunset.png",
		type: "project",
	},
	{
		id: "asset-3",
		name: "Wedding Rings",
		url: "/wedding-rings-macro.png",
		type: "project",
	},
	{
		id: "asset-4",
		name: "Wedding Party",
		url: "/happy-wedding-party.png",
		type: "project",
	},
	{
		id: "asset-5",
		name: "Wedding Invitation",
		url: "/elegant-wedding-invitation.png",
		type: "project",
	},
	{
		id: "asset-6",
		name: "Birthday Invitation",
		url: "/fun-birthday-invitation.png",
		type: "project",
	},
] as const;
