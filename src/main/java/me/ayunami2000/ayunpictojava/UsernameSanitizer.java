package me.ayunami2000.ayunpictojava;

/** Shared server-side Unicode username policy. */
public final class UsernameSanitizer {
    private UsernameSanitizer() {}

    public static String sanitize(String input) {
        if (input == null) return "";
        String name = input.replaceAll("[^\\p{L}\\p{M}\\p{N}_ ]", "").trim();
        int length = Math.min(10, name.codePointCount(0, name.length()));
        return name.substring(0, name.offsetByCodePoints(0, length));
    }
}
