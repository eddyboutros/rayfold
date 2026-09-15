package dev.rayfold.spring.secure;

import dev.rayfold.java.Context;
import dev.rayfold.java.Values;
import dev.rayfold.spring.Arg;
import dev.rayfold.spring.RayfoldCommand;
import dev.rayfold.spring.RayfoldQuery;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/** An application on Spring Security: the starter takes the viewer from the signed-in user, with no code of its own. */
@SpringBootApplication
public class SecureApplication {
    @Bean
    SecurityFilterChain security(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(a -> a.anyRequest().permitAll())
            .httpBasic(Customizer.withDefaults())
            .csrf(c -> c.ignoringRequestMatchers("/rayfold/**"))
            .build();
    }

    @Bean
    UserDetailsService users() {
        return new InMemoryUserDetailsManager(
            User.withUsername("ada").password("{noop}lovelace").roles("ADMIN", "AUTHOR").build(),
            User.withUsername("grace").password("{noop}hopper").roles("ADMIN").build(),
            User.withUsername("bob").password("{noop}builder").roles("USER").build());
    }

    @Component
    public static final class Resolvers {
        public record Post(String id, String title, boolean retired) {}

        final Map<String, Post> posts = new ConcurrentHashMap<>();
        final AtomicInteger retirements = new AtomicInteger();

        public Resolvers() {
            reset();
        }

        public void reset() {
            posts.clear();
            posts.put("p1", new Post("p1", "Launch notes", false));
            retirements.set(0);
        }

        @RayfoldQuery("me")
        public String me(Context ctx) {
            Values v = ctx.viewer();
            return v == null ? "anonymous" : v.getString("id") + " " + v.getString("role") + " " + v.getList("roles");
        }

        @RayfoldQuery("secret")
        public Map<String, Object> secret(@Arg String id) {
            return Map.of("id", id, "note", "classified");
        }

        /** The schema lets only an ADMIN run this; the resolver itself checks nothing. */
        @RayfoldCommand("retire")
        public Post retire(@Arg String id) {
            retirements.incrementAndGet();
            Post retired = new Post(id, posts.get(id).title(), true);
            posts.put(id, retired);
            return retired;
        }
    }
}
