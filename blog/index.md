---
layout: default
title: Blog
---

<div class="container py-5">
  <div class="posts">
    <h1>Blog Posts</h1>

    <div class="post-list">
      {% for post in site.posts %}
        <article class="post-preview">
          <h2>
            <a href="{{ post.url | relative_url }}">{{ post.title }}</a>
          </h2>
          <p class="post-meta">{{ post.date | date: "%B %-d, %Y" }}</p>
          <p class="post-excerpt">{{ post.excerpt }}</p>
          <a href="{{ post.url | relative_url }}" class="read-more">Read More &raquo;</a>
        </article>
      {% endfor %}
    </div>

    {% if site.posts.size == 0 %}
      <p>No posts yet. Check back soon!</p>
    {% endif %}
  </div>
</div>