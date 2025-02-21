# Deployment Guide

This website is designed to be hosted on GitHub Pages. Follow these steps to deploy:

1. Create a new repository on GitHub named `junkim100.github.io`

2. Initialize git and push the code:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/junkim100/junkim100.github.io.git
git push -u origin main
```

3. Go to your repository settings on GitHub:
   - Navigate to "Settings" > "Pages"
   - Under "Source", select "main" branch
   - Click "Save"

4. Your site will be published at `https://junkim100.github.io`

## Local Development

To run the site locally:

1. Install Ruby and Bundler
2. Run `bundle install`
3. Run `bundle exec jekyll serve`
4. Visit `http://localhost:4000`

## File Structure

- `_config.yml`: Main configuration file
- `_layouts/`: Contains HTML templates
- `_includes/`: Contains reusable components
- `assets/`: Contains CSS, JavaScript, and images
- `_posts/`: Contains blog posts
- `index.md`: Homepage content
