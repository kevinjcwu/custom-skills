/* global document */
// Synthetic fixture: renders three fixed recipe cards.
const recipes = ["Tomato soup", "Lemon rice", "Oat cookies"];

const list = document.getElementById("cards");
for (const name of recipes) {
	const item = document.createElement("li");
	item.textContent = name;
	list.append(item);
}
