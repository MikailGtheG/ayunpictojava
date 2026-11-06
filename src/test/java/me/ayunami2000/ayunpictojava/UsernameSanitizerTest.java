package me.ayunami2000.ayunpictojava;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class UsernameSanitizerTest {
    @Test public void preservesGermanAndTurkishLetters() {
        assertEquals("Müller", UsernameSanitizer.sanitize("Müller"));
        assertEquals("Çağrı", UsernameSanitizer.sanitize("Çağrı"));
        assertEquals("Şükrü", UsernameSanitizer.sanitize("Şükrü"));
    }

    @Test public void removesPunctuationAndTrims() {
        assertEquals("Äbc_", UsernameSanitizer.sanitize("  Äbc_!? "));
        assertEquals("", UsernameSanitizer.sanitize(null));
    }

    @Test public void truncatesByCodePointNotUtf16Char() {
        assertEquals("𐐀abcdefghi", UsernameSanitizer.sanitize("𐐀abcdefghijk"));
    }
}
