(function () {
  var fallbackUrl = "/img/student-placeholder.svg";

  document.addEventListener("error", function (event) {
    var image = event.target;
    if (!image || image.tagName !== "IMG") return;
    if (!image.closest(".leaderboard-ref, .leaderboard-slideshow-modal, .leaderboard-photo-modal")) return;
    if (image.getAttribute("src") === fallbackUrl) return;

    image.setAttribute("src", fallbackUrl);
    var avatarButton = image.closest(".leaderboard-photo-button");
    if (avatarButton) avatarButton.setAttribute("data-photo-src", fallbackUrl);
  }, true);
}());
